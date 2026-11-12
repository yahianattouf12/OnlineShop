using Microsoft.EntityFrameworkCore;
using Shop.Api.Common.Data;

namespace Shop.Api.Modules.Orders;

public static class OrdersModule
{
    internal const string AdminReadDatabase = "admin-orders-read";

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

        var replicaConnection = configuration.GetConnectionString("OrdersReadReplica");
        services.AddKeyedScoped<OrdersDbContext>(AdminReadDatabase, (provider, _) =>
        {
            var primaryOptions = provider.GetRequiredService<DbContextOptions<OrdersDbContext>>();
            var readOptions = new DbContextOptionsBuilder<OrdersDbContext>(primaryOptions);
            if (!string.IsNullOrWhiteSpace(replicaConnection))
                readOptions.UseNpgsql(replicaConnection);

            return new OrdersDbContext(readOptions.Options);
        });

        services.AddHostedService<DatabaseMigrator<OrdersDbContext>>();
        services.AddScoped<OrdersService>();

        return services;
    }
}
