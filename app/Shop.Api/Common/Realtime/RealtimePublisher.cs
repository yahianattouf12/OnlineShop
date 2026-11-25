using PusherServer;

namespace Shop.Api.Common.Realtime;

/// <summary>Sends an event to every browser subscribed to a channel, through Soketi.</summary>
public interface IRealtimePublisher
{
    /// <summary>Best effort: never throws. The data is already saved; a missed live update is only logged.</summary>
    Task TryPublishAsync(string channel, string eventName, object data);
}

public class RealtimePublisher : IRealtimePublisher
{
    private readonly IPusher _pusher;
    private readonly ILogger<RealtimePublisher> _logger;

    public RealtimePublisher(IPusher pusher, ILogger<RealtimePublisher> logger)
    {
        _pusher = pusher;
        _logger = logger;
    }

    public async Task TryPublishAsync(string channel, string eventName, object data)
    {
        try
        {
            // One HTTP call to Soketi ("trigger"). Soketi pushes it over the open WebSockets.
            await _pusher.TriggerAsync(channel, eventName, data);
        }
        catch (Exception e)
        {
            // The user can still reload the page; the order itself is fine.
            _logger.LogWarning(e, "Could not send the live event {Event} on {Channel}", eventName, channel);
        }
    }
}
