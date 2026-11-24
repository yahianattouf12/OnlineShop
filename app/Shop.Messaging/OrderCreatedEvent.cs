using System.Text.Json;

namespace Shop.Messaging;

/// <summary>
/// Requirement 4: the message the API publishes when an order is placed. It carries everything the email
/// worker needs (even the customer's email), so the worker never has to read the shop's database.
/// EventId is unique per event: if the same message is delivered twice, the worker can tell.
/// </summary>
public record OrderCreatedEvent(
    Guid EventId,
    Guid OrderId,
    string CustomerEmail,
    decimal TotalAmount,
    IReadOnlyList<OrderCreatedItem> Items,
    DateTime CreatedAt);

public record OrderCreatedItem(string ProductName, int Quantity, decimal UnitPrice);

public static class MessageJson
{
    /// <summary>The same JSON settings on both sides (camelCase), so what the API writes the worker can read.</summary>
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}
