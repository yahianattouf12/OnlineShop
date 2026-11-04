using Grpc.Core;
using Microsoft.Extensions.Options;
using Shop.Api.Common.Errors;
using Shop.Api.Integrations.Inventory.Protos;

namespace Shop.Api.Integrations.Inventory;

/// <summary>
/// Talks to the inventory service over gRPC. Two rules hold for EVERY call:
/// 1. it has a deadline, so a slow or stopped service never makes the user wait forever;
/// 2. a network failure becomes a clear 503 for the user, not a 500.
/// </summary>
public sealed class InventoryClient : IInventoryService
{
    private readonly InventoryService.InventoryServiceClient _client; // generated from proto/inventory.proto
    private readonly InventoryOptions _options;
    private readonly ILogger<InventoryClient> _logger;

    public InventoryClient(
        InventoryService.InventoryServiceClient client,
        IOptions<InventoryOptions> options,
        ILogger<InventoryClient> logger)
    {
        _client = client;
        _options = options.Value;
        _logger = logger;
    }

    public async Task<int> GetStockAsync(Guid productId, CancellationToken ct)
    {
        var request = new GetStockRequest { ProductId = productId.ToString() };
        var reply = await CallAsync("GetStock", () =>
            _client.GetStockAsync(request, deadline: Deadline(), cancellationToken: ct).ResponseAsync);
        return reply.Available;
    }

    public async Task<IReadOnlyList<StockShortage>> ReserveAsync(Guid orderId, IEnumerable<StockItem> items, CancellationToken ct)
    {
        var request = new ReserveRequest { OrderId = orderId.ToString() };
        request.Items.AddRange(items.Select(i => new ReserveItem { ProductId = i.ProductId.ToString(), Quantity = i.Quantity }));

        var reply = await CallAsync("Reserve", () =>
            _client.ReserveAsync(request, deadline: Deadline(), cancellationToken: ct).ResponseAsync);

        if (reply.Reserved)
            return [];

        return reply.Shortages
            .Select(s => new StockShortage(Guid.Parse(s.ProductId), s.Requested, s.Available))
            .ToList();
    }

    public async Task<bool> ReleaseAsync(Guid orderId, CancellationToken ct)
    {
        var request = new ReleaseRequest { OrderId = orderId.ToString() };
        var reply = await CallAsync("Release", () =>
            _client.ReleaseAsync(request, deadline: Deadline(), cancellationToken: ct).ResponseAsync);
        return reply.Released;
    }

    public async Task<int> SetStockAsync(Guid productId, int quantity, CancellationToken ct)
    {
        var request = new SetStockRequest { ProductId = productId.ToString(), Quantity = quantity };
        var reply = await CallAsync("SetStock", () =>
            _client.SetStockAsync(request, deadline: Deadline(), cancellationToken: ct).ResponseAsync);
        return reply.Available;
    }

    /// <summary>A fresh deadline for each call, counted from now.</summary>
    private DateTime Deadline() => DateTime.UtcNow.AddSeconds(_options.TimeoutSeconds);

    private async Task<T> CallAsync<T>(string operation, Func<Task<T>> call)
    {
        try
        {
            return await call();
        }
        catch (RpcException e) when (e.StatusCode is StatusCode.DeadlineExceeded or StatusCode.Unavailable)
        {
            // DeadlineExceeded: the service did not answer in time (slow, or paused).
            // Unavailable: we could not reach it at all (stopped, or the address is wrong).
            _logger.LogWarning("Inventory call {Operation} failed: {Status} ({Detail})", operation, e.StatusCode, e.Status.Detail);
            throw new ServiceUnavailableException("The inventory service is not available right now. Please try again in a moment.");
        }
    }
}