using Microsoft.EntityFrameworkCore;

namespace Shop.Api.Common.Data;

/// <summary>
/// Applies a module's pending migrations when the app starts, so a fresh database works without
/// running "dotnet ef database update" by hand. Each module registers one for its own DbContext.
/// Hosted services start one after another in the order they were registered, and before the
/// server accepts requests, so anything registered after this (e.g. AdminSeeder) sees the tables.
/// Turn it off with Database:MigrateOnStartup = false.
/// </summary>
public class DatabaseMigrator<TContext> : IHostedService where TContext : DbContext
{
    private readonly IServiceProvider _services;
    private readonly IConfiguration _configuration;
    private readonly ILogger<DatabaseMigrator<TContext>> _logger;

    public DatabaseMigrator(IServiceProvider services, IConfiguration configuration, ILogger<DatabaseMigrator<TContext>> logger)
    {
        _services = services;
        _configuration = configuration;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken ct)
    {
        if (!_configuration.GetValue("Database:MigrateOnStartup", true))
            return;

        // The DbContext is scoped (one per request), so make a scope for it.
        await using var scope = _services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TContext>();

        var pending = (await db.Database.GetPendingMigrationsAsync(ct)).ToList();
        if (pending.Count == 0)
            return;

        _logger.LogInformation("Applying {Count} migration(s) for {Context}: {Migrations}",
            pending.Count, typeof(TContext).Name, string.Join(", ", pending));
        await db.Database.MigrateAsync(ct);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
