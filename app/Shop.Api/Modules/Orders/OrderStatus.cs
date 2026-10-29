using System.Text.Json.Serialization;

namespace Shop.Api.Modules.Orders;

/// <summary>Sent and received as text ("Pending"), not as a number, so the API is readable.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<OrderStatus>))]
public enum OrderStatus
{
    Pending,
    Confirmed,
    Shipped,
    Delivered,
    Cancelled,
}

/// <summary>
/// The order life cycle. Only these moves are allowed:
/// Pending → Confirmed → Shipped → Delivered, and Pending/Confirmed → Cancelled.
/// Delivered and Cancelled are final.
/// </summary>
public static class OrderStatusRules
{
    private static readonly Dictionary<OrderStatus, OrderStatus[]> AllowedNext = new()
    {
        [OrderStatus.Pending] = [OrderStatus.Confirmed, OrderStatus.Cancelled],
        [OrderStatus.Confirmed] = [OrderStatus.Shipped, OrderStatus.Cancelled],
        [OrderStatus.Shipped] = [OrderStatus.Delivered],
        [OrderStatus.Delivered] = [],
        [OrderStatus.Cancelled] = [],
    };

    public static bool CanMove(OrderStatus from, OrderStatus to) => AllowedNext[from].Contains(to);

    public static IReadOnlyList<OrderStatus> NextOf(OrderStatus from) => AllowedNext[from];
}
