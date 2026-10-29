using Microsoft.EntityFrameworkCore;
using Shop.Api.Common.Auth;
using Shop.Api.Common.Errors;
using Shop.Api.Common.Paging;
using Shop.Api.Modules.Notifications.Contracts;
using Shop.Api.Modules.Notifications.Dtos;

namespace Shop.Api.Modules.Notifications;

/// <summary>
/// Implements the public INotificationService for other modules, plus the reading side used
/// by NotificationsController. Every read is limited to the caller's own notifications.
/// </summary>
public class NotificationService : INotificationService
{
    private readonly NotificationsDbContext _db;
    private readonly ICurrentUser _currentUser;

    public NotificationService(NotificationsDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task NotifyAsync(Guid userId, string message, Guid? orderId, CancellationToken ct)
    {
        _db.Notifications.Add(new Notification
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Message = message,
            OrderId = orderId,
            CreatedAt = DateTime.UtcNow,
        });
        await _db.SaveChangesAsync(ct);
    }

    public async Task<PagedResponse<NotificationResponse>> ListMineAsync(NotificationQuery query, CancellationToken ct)
    {
        var notifications = MyNotifications().AsNoTracking();

        if (query.UnreadOnly)
            notifications = notifications.Where(n => n.ReadAt == null);

        var totalCount = await notifications.CountAsync(ct);
        var items = await notifications
            .OrderByDescending(n => n.CreatedAt)
            .ThenBy(n => n.Id)
            .Skip((query.Page - 1) * query.PageSize)
            .Take(query.PageSize)
            .Select(n => new NotificationResponse(n.Id, n.Message, n.OrderId, n.CreatedAt, n.ReadAt))
            .ToListAsync(ct);

        return PagedResponse<NotificationResponse>.Create(items, query.Page, query.PageSize, totalCount);
    }

    public async Task<UnreadCountResponse> CountUnreadAsync(CancellationToken ct) =>
        new(await MyNotifications().CountAsync(n => n.ReadAt == null, ct));

    public async Task MarkAsReadAsync(Guid id, CancellationToken ct)
    {
        // Someone else's notification is "not found", exactly like orders (IDOR protection).
        var notification = await MyNotifications().SingleOrDefaultAsync(n => n.Id == id, ct)
            ?? throw new NotFoundException($"Notification {id} was not found.");

        if (notification.ReadAt is null)
        {
            notification.ReadAt = DateTime.UtcNow;
            await _db.SaveChangesAsync(ct);
        }
    }

    public async Task MarkAllAsReadAsync(CancellationToken ct)
    {
        // One UPDATE statement in the database instead of loading every notification.
        var now = DateTime.UtcNow;
        await MyNotifications()
            .Where(n => n.ReadAt == null)
            .ExecuteUpdateAsync(setters => setters.SetProperty(n => n.ReadAt, now), ct);
    }

    /// <summary>The only starting point for reads: notifications of the caller (from the token).</summary>
    private IQueryable<Notification> MyNotifications()
    {
        var userId = _currentUser.Id;
        return _db.Notifications.Where(n => n.UserId == userId);
    }
}
