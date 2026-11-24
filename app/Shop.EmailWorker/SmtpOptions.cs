using System.ComponentModel.DataAnnotations;

namespace Shop.EmailWorker;

/// <summary>
/// The "Smtp" section: the external mail service (Mailtrap, Gmail, ...). The secrets come from .env through
/// environment variables (Smtp__Username, Smtp__Password), never from the code.
/// </summary>
public class SmtpOptions
{
    public const string SectionName = "Smtp";

    [Required] public string Host { get; set; } = "";
    [Range(1, 65535)] public int Port { get; set; } = 587;

    /// <summary>Empty = a server without login (only for a local test server).</summary>
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";

    /// <summary>The sender, e.g. "Online Shop &lt;shop@example.com&gt;".</summary>
    [Required] public string From { get; set; } = "";
}
