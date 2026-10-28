using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Shop.Api.Common.Data;

namespace Shop.Api.Modules.Users;

public static class UsersModule
{
    public static IServiceCollection AddUsersModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddDbContext<UsersDbContext>(options =>
        {
            options.UseNpgsql(
                configuration.GetConnectionString("Default"),
                npgsqlOptions =>
                {
                    npgsqlOptions.MigrationsHistoryTable(
                        "__EFMigrationsHistory",
                        "users");
                });
        });

        services.AddScoped<UsersService>();
        services.AddScoped<IPasswordHasher<User>, PasswordHasher<User>>();

        // Order matters: hosted services start one after another, so the tables exist before the seeder runs.
        services.AddHostedService<DatabaseMigrator<UsersDbContext>>();
        services.AddHostedService<AdminSeeder>();

        return services;
    }
}
