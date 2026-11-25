using System.Net.Http.Headers;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Shop.Api.Common.Data;
using Shop.Messaging;

namespace Shop.Api.Modules.Orders;

public static class OrdersModule
{
    /// <summary>The name of the second OrdersDbContext, the one that reads from the replica.</summary>
    public const string ReadReplica = "orders-read-replica";

    public static IServiceCollection AddOrdersModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddDbContext<OrdersDbContext>(options =>
        {
            options.UseNpgsql(
                configuration.GetConnectionString("Default"),
                npgsqlOptions =>
                {
                    npgsqlOptions.MigrationsHistoryTable(
                        "__EFMigrationsHistory",
                        "orders");
                });
        });

        // Requirement 3: a second OrdersDbContext, registered under a name (a "keyed" service), that reads from
        // the replica. Same model and settings as the normal one; only the connection string is different.
        // Without the replica (no ConnectionStrings__OrdersReadReplica) it simply uses the primary, so nothing breaks.
        var replica = configuration.GetConnectionString("OrdersReadReplica");
        services.AddKeyedScoped<OrdersDbContext>(ReadReplica, (provider, _) =>
        {
            var primaryOptions = provider.GetRequiredService<DbContextOptions<OrdersDbContext>>();
            var builder = new DbContextOptionsBuilder<OrdersDbContext>(primaryOptions);
            if (!string.IsNullOrWhiteSpace(replica))
                builder.UseNpgsql(replica);
            return new OrdersDbContext(builder.Options);
        });

        services.AddHostedService<DatabaseMigrator<OrdersDbContext>>();
        services.AddScoped<OrdersService>();
        
        // Requirement 4: the outbox. Saved orders' events are moved to RabbitMQ in the background.
        services.Configure<RabbitMqOptions>(configuration.GetSection(RabbitMqOptions.SectionName));
        services.AddHostedService<OutboxPublisher>();

        // Requirement 4, the Queue checks page: RabbitMQ's management API (port 15672, the same login).
        services.AddHttpClient(QueueChecksController.ManagementClient, (provider, client) =>
        {
            var options = provider.GetRequiredService<IOptions<RabbitMqOptions>>().Value;
            client.BaseAddress = new Uri($"http://{options.Host}:15672/api/");
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(
                "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{options.User}:{options.Password}")));
            client.Timeout = TimeSpan.FromSeconds(3); // RabbitMQ stopped for a check: answer quickly
        });

        return services;
    }
}
