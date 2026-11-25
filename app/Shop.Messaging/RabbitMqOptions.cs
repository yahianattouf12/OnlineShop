using RabbitMQ.Client;

namespace Shop.Messaging;

/// <summary>The "RabbitMq" section of the configuration (in Docker: RabbitMq__Host, RabbitMq__Password, ...).</summary>
public class RabbitMqOptions
{
    public const string SectionName = "RabbitMq";

    public string Host { get; set; } = "localhost";
    public int Port { get; set; } = 5672;
    public string User { get; set; } = "guest";
    public string Password { get; set; } = "guest";

    /// <summary>clientName shows up in the management UI (Connections), so we can see who is connected.</summary>
    public ConnectionFactory CreateFactory(string clientName) => new()
    {
        HostName = Host,
        Port = Port,
        UserName = User,
        Password = Password,
        ClientProvidedName = clientName,
    };
}
