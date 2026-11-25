using RabbitMQ.Client;

namespace Shop.Messaging;

/// <summary>
/// Requirement 4: the names of everything in RabbitMQ, and the code that creates it. The API (which publishes)
/// and the email worker (which consumes) both call DeclareAsync, so it does not matter which one starts first.
/// Declaring something that already exists with the same settings does nothing.
/// </summary>
public static class Topology
{
    /// <summary>Every event of the shop is published here. "topic": a queue chooses events by their routing key.</summary>
    public const string Exchange = "shop.events";

    /// <summary>Where RabbitMQ sends the messages a queue gives up on (the "Dead Letter Exchange").</summary>
    public const string DeadLetterExchange = "shop.dead-letter";

    /// <summary>The routing key (and the message type) of the "a new order was placed" event.</summary>
    public const string OrderCreated = "order.created";

    /// <summary>The email worker's queue: it gets a copy of every order.created event.</summary>
    public const string EmailQueue = "email.order-created";

    /// <summary>The DLQ: messages that failed every attempt. They wait here for a human, nothing is lost.</summary>
    public const string EmailDeadLetterQueue = "email.order-created.dead";

    public static async Task DeclareAsync(IChannel channel, CancellationToken ct = default)
    {
        // durable: the exchanges and queues survive a RabbitMQ restart.
        await channel.ExchangeDeclareAsync(Exchange, ExchangeType.Topic, durable: true, autoDelete: false, cancellationToken: ct);
        await channel.ExchangeDeclareAsync(DeadLetterExchange, ExchangeType.Direct, durable: true, autoDelete: false, cancellationToken: ct);

        // The DLQ, bound to the dead-letter exchange with the main queue's name.
        await channel.QueueDeclareAsync(EmailDeadLetterQueue, durable: true, exclusive: false, autoDelete: false, cancellationToken: ct);
        await channel.QueueBindAsync(EmailDeadLetterQueue, DeadLetterExchange, routingKey: EmailQueue, cancellationToken: ct);

        // The main queue. When a message is rejected without requeue (BasicNack(requeue: false)), RabbitMQ does
        // not delete it: it re-publishes it to the dead-letter exchange, which puts it in the DLQ.
        var arguments = new Dictionary<string, object?>
        {
            ["x-dead-letter-exchange"] = DeadLetterExchange,
            ["x-dead-letter-routing-key"] = EmailQueue,
        };
        await channel.QueueDeclareAsync(EmailQueue, durable: true, exclusive: false, autoDelete: false, arguments: arguments, cancellationToken: ct);
        await channel.QueueBindAsync(EmailQueue, Exchange, routingKey: OrderCreated, cancellationToken: ct);
    }
}
