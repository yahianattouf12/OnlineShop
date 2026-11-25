using System.Text.Json;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using RabbitMQ.Client.Exceptions;
using Shop.Messaging;

namespace Shop.EmailWorker;

/// <summary>
/// Requirement 4, the worker: takes "order.created" messages from RabbitMQ and sends the confirmation email.
/// Nothing is lost:
///  * ack only AFTER the email is sent. If the worker stops or crashes before that, RabbitMQ gives the
///    message to the worker again when it is back.
///  * a failed send is tried again (3 more times, waiting longer each time).
///  * a message that still fails, or cannot even be read, is rejected without requeue: RabbitMQ moves it,
///    through the dead-letter exchange, to the DLQ. It does not block the queue, and it is not deleted.
/// </summary>
public class OrderEmailConsumer : BackgroundService
{
    private static readonly TimeSpan[] RetryDelays = [TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10)];

    private readonly RabbitMqOptions _rabbit;
    private readonly EmailSender _emails;
    private readonly ILogger<OrderEmailConsumer> _logger;

    public OrderEmailConsumer(IOptions<RabbitMqOptions> rabbit, EmailSender emails, ILogger<OrderEmailConsumer> logger)
    {
        _rabbit = rabbit.Value;
        _emails = emails;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await using var connection = await ConnectAsync(stoppingToken);
        await using var channel = await connection.CreateChannelAsync(cancellationToken: stoppingToken);
        await Topology.DeclareAsync(channel, stoppingToken);

        // prefetch 1: RabbitMQ gives us ONE message at a time and the next only after the ack. So an unsent
        // email is never sitting in this worker's memory while others wait; they stay safe in the queue.
        await channel.BasicQosAsync(prefetchSize: 0, prefetchCount: 1, global: false, stoppingToken);

        var consumer = new AsyncEventingBasicConsumer(channel);
        consumer.ReceivedAsync += (_, delivery) => HandleAsync(channel, delivery, stoppingToken);

        // autoAck: false is the key line: the message is deleted only when WE say so (BasicAckAsync).
        await channel.BasicConsumeAsync(Topology.EmailQueue, autoAck: false, consumer, stoppingToken);
        _logger.LogInformation("Waiting for messages on {Queue}", Topology.EmailQueue);

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken); // the consumer does the work; we just stay alive
        }
        catch (OperationCanceledException)
        {
            _logger.LogInformation("Stopping. Messages not acked yet go back to the queue.");
        }
    }

    private async Task HandleAsync(IChannel channel, BasicDeliverEventArgs delivery, CancellationToken stoppingToken)
    {
        OrderCreatedEvent? order = null;
        try
        {
            order = JsonSerializer.Deserialize<OrderCreatedEvent>(delivery.Body.Span, MessageJson.Options);
        }
        catch (JsonException e)
        {
            _logger.LogError(e, "Message {MessageId} is not valid JSON", delivery.BasicProperties.MessageId);
        }

        // Valid JSON is not enough: {"test":1} is valid JSON but not an order. Without an address or items
        // there is nothing to send, and trying again would fail the same way: straight to the DLQ.
        if (order is null || string.IsNullOrWhiteSpace(order.CustomerEmail) || order.Items is null)
        {
            _logger.LogError("Message {MessageId} is not a valid order.created event; moving it to the DLQ",
                delivery.BasicProperties.MessageId);
            await channel.BasicNackAsync(delivery.DeliveryTag, multiple: false, requeue: false, CancellationToken.None);
            return;
        }

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await _emails.SendOrderConfirmationAsync(order, stoppingToken);

                // Only now: "done, delete it". CancellationToken.None: the email is out, so the ack must go too.
                await channel.BasicAckAsync(delivery.DeliveryTag, multiple: false, CancellationToken.None);
                _logger.LogInformation("Email for order {OrderId} sent to {Email} (attempt {Attempt}{Redelivered})",
                    order.OrderId, order.CustomerEmail, attempt, delivery.Redelivered ? ", redelivered" : "");
                return;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                if (attempt > RetryDelays.Length)
                {
                    _logger.LogError(e, "Email for order {OrderId} failed {Attempts} times; moving it to the DLQ",
                        order.OrderId, attempt);
                    await channel.BasicNackAsync(delivery.DeliveryTag, multiple: false, requeue: false, CancellationToken.None);
                    return;
                }

                var delay = RetryDelays[attempt - 1];
                _logger.LogWarning("Email for order {OrderId} failed (attempt {Attempt}: {Error}); trying again in {Delay}",
                    order.OrderId, attempt, e.Message, delay);
                // If the worker is stopped during this wait, the message is not acked, so it goes back to the queue.
                await Task.Delay(delay, stoppingToken);
            }
        }
    }

    /// <summary>When everything starts together, RabbitMQ may not be ready yet: keep trying.</summary>
    private async Task<IConnection> ConnectAsync(CancellationToken ct)
    {
        while (true)
        {
            try
            {
                var connection = await _rabbit.CreateFactory("shop-email-worker").CreateConnectionAsync(ct);
                _logger.LogInformation("Connected to RabbitMQ at {Host}", _rabbit.Host);
                return connection;
            }
            catch (BrokerUnreachableException e)
            {
                _logger.LogWarning("RabbitMQ is not reachable yet ({Error}); trying again in 5 s", e.Message);
                await Task.Delay(TimeSpan.FromSeconds(5), ct);
            }
        }
    }
}
