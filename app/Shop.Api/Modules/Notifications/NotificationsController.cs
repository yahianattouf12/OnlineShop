using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Shop.Api.Common;
using Shop.Api.Common.Paging;
using Shop.Api.Modules.Notifications.Dtos;

namespace Shop.Api.Modules.Notifications;

/// <summary>
/// The logged-in user's own notifications. There is no endpoint that creates a notification:
/// they are only created inside the app (e.g. by the Orders module), so nobody can send fake ones.
/// </summary>
[ApiController]
[Route(ApiRoutes.V1 + "/notifications")]
[Authorize]
public class NotificationsController : ControllerBase
{
    private readonly NotificationService _notificationService;

    public NotificationsController(NotificationService notificationService)
    {
        _notificationService = notificationService;
    }

    [HttpGet]
    public Task<PagedResponse<NotificationResponse>> List([FromQuery] NotificationQuery query, CancellationToken ct) =>
        _notificationService.ListMineAsync(query, ct);

    [HttpGet("unread-count")]
    public Task<UnreadCountResponse> UnreadCount(CancellationToken ct) =>
        _notificationService.CountUnreadAsync(ct);

    /// <summary>Marks one of your notifications as read. Someone else's returns 404.</summary>
    [HttpPatch("{id:guid}/read")]
    public async Task<IActionResult> MarkAsRead(Guid id, CancellationToken ct)
    {
        await _notificationService.MarkAsReadAsync(id, ct);
        return NoContent();
    }

    [HttpPost("read-all")]
    public async Task<IActionResult> MarkAllAsRead(CancellationToken ct)
    {
        await _notificationService.MarkAllAsReadAsync(ct);
        return NoContent();
    }
}
