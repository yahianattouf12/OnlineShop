using Microsoft.EntityFrameworkCore;
using Shop.Api.Common.Data;

namespace Shop.Api.Modules.Orders;

public static class OrdersModule
{
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

        services.AddHostedService<DatabaseMigrator<OrdersDbContext>>();
        services.AddScoped<OrdersService>();

        return services;
    }
}
