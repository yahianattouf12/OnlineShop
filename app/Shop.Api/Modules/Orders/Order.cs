namespace Shop.Api.Modules.Orders;

public class Order
{
    public Guid Id { get; set; }

    public Guid UserId { get; set; }

    public OrderStatus Status { get; set; }

    public decimal TotalAmount { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    /// <summary>
    /// PostgreSQL's hidden row version (xmin). If two admins change the same order at the same time,
    /// the second save fails instead of silently overwriting the first (optimistic concurrency).
    /// </summary>
    public uint Version { get; set; }

    public List<OrderItem> Items { get; set; } = [];
    public List<OrderStatusChange> StatusHistory { get; set; } = [];
}

/// <summary>One line of an order. Name and price are copied (a snapshot) so later price changes do not alter old orders.</summary>
public class OrderItem
{
    public Guid Id { get; set; }
    public Guid OrderId { get; set; }

    public Guid ProductId { get; set; }

    public string ProductName { get; set; } = "";
    public decimal UnitPrice { get; set; }
    public int Quantity { get; set; }
}

public class OrderStatusChange
{
    public Guid Id { get; set; }
    public Guid OrderId { get; set; }
    public OrderStatus Status { get; set; }
    public DateTime ChangedAt { get; set; }
    public Guid ChangedByUserId { get; set; }
}
