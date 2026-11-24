using System.Text.Json;
using Shop.Messaging;

namespace Shop.Api.Modules.Orders;

/// <summary>
/// Requirement 4, the "outbox": an event that must reach RabbitMQ. It is saved in the SAME transaction as the
/// order, so either both are saved or neither is. OutboxPublisher then sends it to RabbitMQ in the background.
/// Without it, "order saved but RabbitMQ was down at that moment" would lose the confirmation email.
/// </summary>
public class OutboxMessage
{
    /// <summary>The event's id. Also sent as the RabbitMQ MessageId, so a duplicate can be recognised.</summary>
    public Guid Id { get; set; }

    /// <summary>The routing key in RabbitMQ, e.g. "order.created".</summary>
    public string Type { get; set; } = "";

    /// <summary>The event as JSON, exactly the bytes that go to RabbitMQ.</summary>
    public string Payload { get; set; } = "";

    public DateTime CreatedAt { get; set; }

    /// <summary>Null until RabbitMQ has confirmed it has the message.</summary>
    public DateTime? PublishedAt { get; set; }

    public static OutboxMessage OrderCreated(OrderCreatedEvent e) => new()
    {
        Id = e.EventId,
        Type = Topology.OrderCreated,
        Payload = JsonSerializer.Serialize(e, MessageJson.Options),
        CreatedAt = e.CreatedAt,
    };
}
