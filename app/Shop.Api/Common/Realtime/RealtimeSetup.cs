using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using PusherServer;

namespace Shop.Api.Common.Realtime;

public static class RealtimeSetup
{
    /// <summary>Registers the Pusher client, pointed at Soketi instead of pusher.com.</summary>
    public static IServiceCollection AddRealtime(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<RealtimeOptions>(configuration.GetSection(RealtimeOptions.SectionName));

        services.AddSingleton<IPusher>(provider =>
        {
            var options = provider.GetRequiredService<IOptions<RealtimeOptions>>().Value;
            return new Pusher(options.AppId, options.Key, options.Secret, new PusherOptions
            {
                HostName = options.Host,
                Port = options.Port,
                Encrypted = false, // plain HTTP inside the Docker network
                // A slow or dead Soketi must not hold an order request for long (the default is 30 s).
                RestClientTimeout = TimeSpan.FromSeconds(2),
                JsonSerializer = new CamelCaseJson(), // the same JSON style as the rest of our API
            });
        });

        services.AddSingleton<IRealtimePublisher, RealtimePublisher>();
        return services;
    }

    /// <summary>PusherServer uses Newtonsoft (PascalCase) by default; the browser expects camelCase like our API.</summary>
    private sealed class CamelCaseJson : ISerializeObjectsToJson
    {
        private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Converters = { new JsonStringEnumConverter() },
        };

        public string Serialize(object objectToSerialize) => JsonSerializer.Serialize(objectToSerialize, Options);
    }
}
