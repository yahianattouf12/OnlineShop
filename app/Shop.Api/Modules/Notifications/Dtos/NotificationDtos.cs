using System.ComponentModel.DataAnnotations;

namespace Shop.Api.Modules.Notifications.Dtos;

/// <summary>GET /notifications?unreadOnly=true&amp;page=1&amp;pageSize=10</summary>
public class NotificationQuery
{
    public bool UnreadOnly { get; set; }

    [Range(1, 10_000)]
    public int Page { get; set; } = 1;

    [Range(1, 50)]
    public int PageSize { get; set; } = 10;
}

public record NotificationResponse(Guid Id, string Message, Guid? OrderId, DateTime CreatedAt, DateTime? ReadAt);

public record UnreadCountResponse(int Count);
