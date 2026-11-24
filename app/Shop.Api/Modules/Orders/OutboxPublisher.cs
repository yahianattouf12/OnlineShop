using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using Shop.Messaging;

namespace Shop.Api.Modules.Orders;

/// <summary>
/// Requirement 4: runs in the background of the API and moves saved outbox messages to RabbitMQ.
/// A message is marked as published only after RabbitMQ confirms it has stored it (publisher confirms).
/// If RabbitMQ is down, nothing is lost: the messages wait in the database and go out when it is back.
/// </summary>
public class OutboxPublisher : BackgroundService
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(5);
    private const int BatchSize = 50;

    private readonly IServiceScopeFactory _scopes;
    private readonly RabbitMqOptions _options;
    private readonly ILogger<OutboxPublisher> _logger;

    private IConnection? _connection;
    private IChannel? _channel;

    public OutboxPublisher(IServiceScopeFactory scopes, IOptions<RabbitMqOptions> options, ILogger<OutboxPublisher> logger)
    {
        _scopes = scopes;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var published = await PublishBatchAsync(stoppingToken);
                if (published == BatchSize)
                    continue; // a full batch: there may be more waiting, so go again at once
                await Task.Delay(PollInterval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // the API is shutting down
            }
            catch (Exception e)
            {
                // RabbitMQ is down, or the database is: try again later. The messages stay in the outbox.
                _logger.LogWarning(e, "Could not publish the outbox to RabbitMQ; trying again in {Delay}", RetryDelay);
                await CloseAsync();
                await Task.Delay(RetryDelay, stoppingToken);
            }
        }

        await CloseAsync();
    }

    private async Task<int> PublishBatchAsync(CancellationToken ct)
    {
        // A BackgroundService lives as long as the app, but a DbContext must live short: one scope per batch.
        using var scope = _scopes.CreateScope();
        // The same settings as the normal OrdersDbContext, but without EF's SQL log: this query runs every second,
        // and its log lines would bury everything else (and break the "count the SQL queries" checks of Requirement 3).
        var options = new DbContextOptionsBuilder<OrdersDbContext>(
                scope.ServiceProvider.GetRequiredService<DbContextOptions<OrdersDbContext>>())
            .UseLoggerFactory(NullLoggerFactory.Instance)
            .Options;
        await using var db = new OrdersDbContext(options);

        var messages = await db.OutboxMessages
            .Where(m => m.PublishedAt == null)
            .OrderBy(m => m.CreatedAt)
            .Take(BatchSize)
            .ToListAsync(ct);
        if (messages.Count == 0)
            return 0;

        var channel = await GetChannelAsync(ct);
        foreach (var message in messages)
        {
            var properties = new BasicProperties
            {
                Persistent = true, // RabbitMQ writes it to disk: it survives a RabbitMQ restart
                MessageId = message.Id.ToString(),
                Type = message.Type,
                ContentType = "application/json",
            };

            // Publisher confirms are on (see GetChannelAsync), so this waits until RabbitMQ has the message,
            // and throws if RabbitMQ refuses it or no queue takes it (mandatory: true).
            await channel.BasicPublishAsync(Topology.Exchange, message.Type, mandatory: true, properties,
                Encoding.UTF8.GetBytes(message.Payload), ct);

            // Saved after every message. If the API crashes between the publish and this line, the message is
            // sent again next time: "at least once". The worker must therefore cope with a duplicate.
            message.PublishedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            _logger.LogInformation("Published {Type} {MessageId} to RabbitMQ", message.Type, message.Id);
        }

        return messages.Count;
    }

    private async Task<IChannel> GetChannelAsync(CancellationToken ct)
    {
        if (_channel is { IsOpen: true })
            return _channel;

        await CloseAsync();
        _connection = await _options.CreateFactory("shop-api (outbox)").CreateConnectionAsync(ct);
        _channel = await _connection.CreateChannelAsync(
            new CreateChannelOptions(publisherConfirmationsEnabled: true, publisherConfirmationTrackingEnabled: true),
            ct);
        await Topology.DeclareAsync(_channel, ct);
        _logger.LogInformation("Connected to RabbitMQ at {Host}", _options.Host);
        return _channel;
    }

    private async Task CloseAsync()
    {
        try
        {
            if (_channel is not null) await _channel.DisposeAsync();
            if (_connection is not null) await _connection.DisposeAsync();
        }
        catch (Exception e)
        {
            _logger.LogDebug(e, "Error while closing the RabbitMQ connection");
        }
        finally
        {
            _channel = null;
            _connection = null;
        }
    }
}
