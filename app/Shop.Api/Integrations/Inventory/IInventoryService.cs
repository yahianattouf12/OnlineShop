namespace Shop.Api.Integrations.Inventory;

/// <summary>
/// What the app needs from the inventory service. Orders and Products use this interface,
/// never the generated gRPC classes, so the rest of the code does not care how the call travels.
/// Every method throws ServiceUnavailableException (503) when the service is down or too slow.
/// </summary>
public interface IInventoryService
{
    Task<int> GetStockAsync(Guid productId, CancellationToken ct);

    /// <summary>Reserves all the items or none. Returns the shortages: an empty list means everything was reserved.</summary>
    Task<IReadOnlyList<StockShortage>> ReserveAsync(Guid orderId, IEnumerable<StockItem> items, CancellationToken ct);

    /// <summary>Gives back what the order reserved. Returns false if there was nothing to give back.</summary>
    Task<bool> ReleaseAsync(Guid orderId, CancellationToken ct);

    Task<int> SetStockAsync(Guid productId, int quantity, CancellationToken ct);
}

public record StockItem(Guid ProductId, int Quantity);

public record StockShortage(Guid ProductId, int Requested, int Available);