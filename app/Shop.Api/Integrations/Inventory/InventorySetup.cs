using Microsoft.Extensions.Options;
using Shop.Api.Integrations.Inventory.Protos;

namespace Shop.Api.Integrations.Inventory;

public static class InventorySetup
{
    /// <summary>The gRPC client of the inventory service (Requirement 2).</summary>
    public static IServiceCollection AddInventoryClient(this IServiceCollection services, IConfiguration configuration)
    {
        // A missing or wrong Inventory:Address stops the app at startup, not at the first order.
        services.AddOptions<InventoryOptions>()
            .Bind(configuration.GetSection(InventoryOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        // The factory creates the generated client and reuses the same HTTP/2 connection for all calls.
        services.AddGrpcClient<InventoryService.InventoryServiceClient>((serviceProvider, options) =>
            {
                options.Address = new Uri(serviceProvider.GetRequiredService<IOptions<InventoryOptions>>().Value.Address);
            })
            .ConfigureChannel(channel =>
            {
                // After the service goes down, gRPC waits longer and longer between reconnect attempts
                // (up to 2 minutes by default). 5 seconds at most: when it is back, we notice quickly.
                channel.MaxReconnectBackoff = TimeSpan.FromSeconds(5);
            });

        services.AddScoped<IInventoryService, InventoryClient>();

        return services;
    }
}