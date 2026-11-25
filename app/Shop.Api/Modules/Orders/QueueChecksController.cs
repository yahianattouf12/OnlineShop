using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Shop.Api.Common;
using Shop.Api.Common.Auth;
using Shop.Messaging;

namespace Shop.Api.Modules.Orders;

/// <summary>
/// Requirement 4: what the "Queue checks" page (web/src/pages/QueueChecksPage.tsx) needs to show the queue at
/// work in the browser: the outbox, RabbitMQ's email queue and its DLQ, and one broken event to watch the DLQ.
/// Admins only. RabbitMQ's numbers come from its management API, so they are the ones http://localhost:15672 shows.
/// </summary>
[ApiController]
[Route(ApiRoutes.V1 + "/queue-checks")]
[Authorize(Roles = Roles.Admin)]
public class QueueChecksController : ControllerBase
{
    /// <summary>The HttpClient for RabbitMQ's management API (registered in OrdersModule).</summary>
    public const string ManagementClient = "rabbitmq-management";

    private readonly OrdersDbContext _db;
    private readonly IHttpClientFactory _httpClients;

    public QueueChecksController(OrdersDbContext db, IHttpClientFactory httpClients)
    {
        _db = db;
        _httpClients = httpClients;
    }

    /// <summary>
    /// Events still waiting in the outbox, and the two queues. If RabbitMQ does not answer (stopped on purpose
    /// for a check), the outbox count still comes back, with rabbitMqReachable = false.
    /// </summary>
    [HttpGet("status")]
    public async Task<QueueStatusResponse> Status(CancellationToken ct)
    {
        var outboxPending = await _db.OutboxMessages.CountAsync(m => m.PublishedAt == null, ct);
        try
        {
            var client = _httpClients.CreateClient(ManagementClient);
            var email = await ReadQueueAsync(client, Topology.EmailQueue, ct);
            var dead = await ReadQueueAsync(client, Topology.EmailDeadLetterQueue, ct);
            return new QueueStatusResponse(outboxPending, true, email, dead);
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            return new QueueStatusResponse(outboxPending, false, null, null);
        }
    }

    /// <summary>
    /// Puts one broken order.created event in the outbox: no customer email and no items. It travels the normal
    /// way (outbox, RabbitMQ, worker); the worker cannot handle it and rejects it, so it ends up in the DLQ.
    /// Development only, like GET /orders/legacy: a test helper, not a feature.
    /// </summary>
    [HttpPost("broken-message")]
    public async Task<IActionResult> SendBrokenMessage([FromServices] IWebHostEnvironment env, CancellationToken ct)
    {
        if (!env.IsDevelopment())
            return NotFound();

        var message = new OutboxMessage
        {
            Id = Guid.NewGuid(),
            Type = Topology.OrderCreated,
            Payload = JsonSerializer.Serialize(new { note = "Queue checks: a broken event (no customerEmail, no items)." }),
            CreatedAt = DateTime.UtcNow,
        };
        _db.OutboxMessages.Add(message);
        await _db.SaveChangesAsync(ct);
        return Accepted(new BrokenMessageResponse(message.Id));
    }

    /// <summary>
    /// The messages in the DLQ, read without removing them (RabbitMQ puts them back), with the "x-death" header
    /// RabbitMQ added: why the message died and which queue it came from.
    /// </summary>
    [HttpGet("dead-letters")]
    public async Task<IReadOnlyList<DeadLetterResponse>> DeadLetters(CancellationToken ct)
    {
        var client = _httpClients.CreateClient(ManagementClient);
        using var response = await client.PostAsJsonAsync(
            $"queues/%2F/{Topology.EmailDeadLetterQueue}/get",
            new { count = 20, ackmode = "ack_requeue_true", encoding = "auto" },
            ct);
        response.EnsureSuccessStatusCode();

        var messages = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        return messages.EnumerateArray().Select(m =>
        {
            var properties = m.GetProperty("properties");
            var messageId = properties.TryGetProperty("message_id", out var id) ? id.GetString() : null;
            JsonElement? xDeath = properties.TryGetProperty("headers", out var headers) && headers.TryGetProperty("x-death", out var death)
                ? death.Clone()
                : null;
            return new DeadLetterResponse(messageId, ParseJson(m.GetProperty("payload").GetString()), xDeath);
        }).ToList();
    }

    private static async Task<QueueStats> ReadQueueAsync(HttpClient client, string queue, CancellationToken ct)
    {
        // "%2F" is the default virtual host "/", written so it fits in a URL.
        using var response = await client.GetAsync($"queues/%2F/{queue}", ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
            return new QueueStats(0, 0, 0, 0); // not declared yet: the API or the worker declares it at start
        response.EnsureSuccessStatusCode();

        var q = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        return new QueueStats(
            Number(q, "messages_ready"),
            Number(q, "messages_unacknowledged"),
            (int)Number(q, "consumers"),
            // How many messages a consumer has acked since RabbitMQ started: for the email queue, the emails sent.
            q.TryGetProperty("message_stats", out var stats) ? Number(stats, "ack") : 0);
    }

    private static long Number(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt64() : 0;

    private static JsonElement? ParseJson(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        try
        {
            return JsonDocument.Parse(text).RootElement.Clone();
        }
        catch (JsonException)
        {
            return JsonSerializer.SerializeToElement(text); // not JSON: show it as a string
        }
    }
}

public record QueueStatusResponse(int OutboxPending, bool RabbitMqReachable, QueueStats? EmailQueue, QueueStats? DeadLetterQueue);

/// <summary>Ready: waiting for a worker. Unacked: a worker has it now. Consumers: connected workers.</summary>
public record QueueStats(long Ready, long Unacked, int Consumers, long Acked);

public record BrokenMessageResponse(Guid MessageId);

public record DeadLetterResponse(string? MessageId, JsonElement? Payload, JsonElement? XDeath);
