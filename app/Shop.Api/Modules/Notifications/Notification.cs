namespace Shop.Api.Modules.Notifications;

public class Notification
{
    public Guid Id { get; set; }

    /// <summary>Who it is for. Users live in another module, so there is no foreign key.</summary>
    public Guid UserId { get; set; }

    public string Message { get; set; } = "";

    /// <summary>The order it is about, if any, so the client can open it. No foreign key (other module).</summary>
    public Guid? OrderId { get; set; }

    public DateTime CreatedAt { get; set; }

    /// <summary>When the user read it; null means unread.</summary>
    public DateTime? ReadAt { get; set; }
}
