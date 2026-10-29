using System.ComponentModel.DataAnnotations;

namespace Shop.Api.Modules.Orders.Dtos;

/// <summary>
/// The customer only says WHICH products and HOW MANY. There is no user id, price, total or status:
/// the server decides those, so they cannot be faked.
/// </summary>
public class CreateOrderRequest : IValidatableObject
{
    [Required, MinLength(1), MaxLength(20)]
    public List<OrderItemRequest> Items { get; set; } = [];

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        var duplicates = Items
            .Where(i => i.ProductId is not null)
            .GroupBy(i => i.ProductId)
            .Any(g => g.Count() > 1);

        if (duplicates)
            yield return new ValidationResult("Each product may appear only once; use Quantity instead.", [nameof(Items)]);
    }
}

public class OrderItemRequest
{
    // Nullable so a missing id gives "required" instead of silently becoming 00000000-....
    [Required]
    public Guid? ProductId { get; set; }

    [Range(1, 100)]
    public int Quantity { get; set; }
}

public class ChangeOrderStatusRequest
{
    [Required, EnumDataType(typeof(OrderStatus))]
    public OrderStatus? Status { get; set; }
}

/// <summary>GET /orders?status=Pending&amp;page=1&amp;pageSize=10</summary>
public class OrderQuery
{
    [EnumDataType(typeof(OrderStatus))]
    public OrderStatus? Status { get; set; }

    [Range(1, 10_000)]
    public int Page { get; set; } = 1;

    [Range(1, 50)]
    public int PageSize { get; set; } = 10;
}

public record OrderItemResponse(Guid ProductId, string ProductName, decimal UnitPrice, int Quantity, decimal LineTotal);

public record OrderStatusChangeResponse(OrderStatus Status, DateTime ChangedAt);

public record OrderResponse(
    Guid Id,
    Guid UserId,
    OrderStatus Status,
    decimal TotalAmount,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    IReadOnlyList<OrderItemResponse> Items,
    IReadOnlyList<OrderStatusChangeResponse> StatusHistory);

/// <summary>A short version for lists.</summary>
public record OrderSummaryResponse(Guid Id, Guid UserId, OrderStatus Status, decimal TotalAmount, int ItemCount, DateTime CreatedAt);
