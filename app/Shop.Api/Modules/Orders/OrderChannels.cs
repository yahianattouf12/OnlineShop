namespace Shop.Api.Modules.Orders;

/// <summary>
/// Requirement 4: the two live channels and their events. "private-" is Pusher's rule: before the browser may
/// subscribe, our API must sign the request (see RealtimeController.Authorize), so we decide who gets in.
/// </summary>
public static class OrderChannels
{
    /// <summary>Admins only: a new order appears on the dashboard at once.</summary>
    public const string Admin = "private-admin-orders";

    /// <summary>One channel per order, for its owner only: the status changes at once on the order page.</summary>
    public static string ForOrder(Guid orderId) => OrderPrefix + orderId.ToString("D");

    public const string OrderCreatedEvent = "order.created";
    public const string StatusChangedEvent = "order.status-changed";

    private const string OrderPrefix = "private-order-";

    /// <summary>"private-order-&lt;id&gt;" gives the id. Anything else (another format, a made-up name) gives false.</summary>
    public static bool TryGetOrderId(string channel, out Guid orderId)
    {
        orderId = Guid.Empty;
        return channel.StartsWith(OrderPrefix, StringComparison.Ordinal)
            && Guid.TryParseExact(channel[OrderPrefix.Length..], "D", out orderId);
    }
}
