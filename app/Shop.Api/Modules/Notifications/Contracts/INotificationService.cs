namespace Shop.Api.Modules.Notifications.Contracts;

/// <summary>
/// The public door into the Notifications module. Other modules call this to tell a user something;
/// they never write to the notifications table themselves. Later (Requirement 4) the implementation
/// can become asynchronous or real-time without changing any caller.
/// </summary>
public interface INotificationService
{
    /// <summary>Stores a notification for one user. <paramref name="orderId"/> links it to an order, if any.</summary>
    Task NotifyAsync(Guid userId, string message, Guid? orderId, CancellationToken ct);
}
