namespace Shop.Api.Common.Realtime;

/// <summary>
/// Requirement 4: the "Realtime" section of the configuration: how the API reaches Soketi, our ready-made
/// WebSocket server (it speaks the Pusher protocol). In Docker: Realtime__Host, Realtime__Secret, ...
/// AppId, Key and Secret must be the same as in Soketi's settings.
/// </summary>
public class RealtimeOptions
{
    public const string SectionName = "Realtime";

    public string AppId { get; set; } = "";

    /// <summary>Public: the browser needs it to connect.</summary>
    public string Key { get; set; } = "";

    /// <summary>Secret: signs our calls to Soketi and the channel authorizations. Never sent to the browser.</summary>
    public string Secret { get; set; } = "";

    /// <summary>Where the API reaches Soketi's HTTP API (inside Docker: the service name).</summary>
    public string Host { get; set; } = "localhost";
    public int Port { get; set; } = 6001;
}
