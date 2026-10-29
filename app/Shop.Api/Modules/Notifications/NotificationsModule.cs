using Microsoft.EntityFrameworkCore;
using Shop.Api.Common.Data;
using Shop.Api.Modules.Notifications.Contracts;

namespace Shop.Api.Modules.Notifications;

/// <summary>Everything sent to the user (e.g. "your order status changed").</summary>
public static class NotificationsModule
{
    public static IServiceCollection AddNotificationsModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddDbContext<NotificationsDbContext>(options =>
        {
            options.UseNpgsql(
                configuration.GetConnectionString("Default"),
                npgsqlOptions =>
                {
                    npgsqlOptions.MigrationsHistoryTable(
                        "__EFMigrationsHistory",
                        "notifications");
                });
        });

        services.AddHostedService<DatabaseMigrator<NotificationsDbContext>>();

        // One object per request, reachable two ways: as itself (for the controller)
        // and as the public INotificationService (for other modules).
        services.AddScoped<NotificationService>();
        //! i should review this .. what if there isn't a notification service? i should ask claude ai about it 
        services.AddScoped<INotificationService>(sp => sp.GetRequiredService<NotificationService>());

        return services;
    }
}
