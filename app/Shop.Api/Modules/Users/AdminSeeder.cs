namespace Shop.Api.Modules.Users;

/// <summary>
/// At startup, creates the admin account from Admin:Email / Admin:Password if no admin exists.
/// There is no API that creates an admin, so nobody can make themselves one.
/// </summary>
public class AdminSeeder : IHostedService
{
    private readonly IServiceProvider _services;
    private readonly IConfiguration _configuration;
    private readonly ILogger<AdminSeeder> _logger;

    public AdminSeeder(IServiceProvider services, IConfiguration configuration, ILogger<AdminSeeder> logger)
    {
        _services = services;
        _configuration = configuration;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken ct)
    {
        var email = _configuration["Admin:Email"];
        var password = _configuration["Admin:Password"];

        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(password))
        {
            _logger.LogWarning("Admin:Email or Admin:Password is not set, so no admin account was created.");
            return;
        }

        // UsersService uses the DbContext, which lives per request (scoped), so make a scope for it.
        await using var scope = _services.CreateAsyncScope();
        var usersService = scope.ServiceProvider.GetRequiredService<UsersService>();

        // Log instead of crashing: the rest of the app still works without an admin.
        if (!await usersService.EnsureAdminAsync(email, password, ct))
            _logger.LogError("Admin:Email {Email} is already used by a customer account, so no admin was created. " +
                "Set Admin:Email to an address that is not registered.", email);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
