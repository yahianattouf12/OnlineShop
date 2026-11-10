using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Npgsql;
using Shop.Api.Common.Auth;

namespace Shop.Api.Common.Benchmark;

/// <summary>Opt-in measurements for the dedicated local benchmark stack.</summary>
[ApiController]
[Route(ApiRoutes.V1 + "/benchmark/telemetry")]
[Authorize(Roles = Roles.Admin)]
public class BenchmarkTelemetryController(IConfiguration configuration) : ControllerBase
{
    [HttpGet]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        if (configuration["Benchmark:Project"] != "onlineshop-bench") return NotFound();
        using var process = Process.GetCurrentProcess();
        var api = new
        {
            processId = process.Id,
            startedAt = process.StartTime.ToUniversalTime(),
            cpuTotalMs = process.TotalProcessorTime.TotalMilliseconds,
            memoryBytes = process.WorkingSet64,
            logicalProcessors = Environment.ProcessorCount
        };
        object database;
        try
        {
            await using var connection = new NpgsqlConnection(configuration.GetConnectionString("Default"));
            await connection.OpenAsync(ct);
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 3;
            command.CommandText = """
                SELECT json_build_object(
                  'available', true, 'name', datname, 'connections', numbackends,
                  'activeConnections', (SELECT count(*) FROM pg_stat_activity
                    WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()),
                  'commits', xact_commit, 'rollbacks', xact_rollback,
                  'blocksRead', blks_read, 'blocksHit', blks_hit,
                  'rowsReturned', tup_returned, 'rowsFetched', tup_fetched,
                  'rowsInserted', tup_inserted, 'rowsUpdated', tup_updated, 'rowsDeleted', tup_deleted,
                  'tempBytes', temp_bytes, 'deadlocks', deadlocks, 'statsReset', stats_reset)
                FROM pg_stat_database WHERE datname = current_database()
                """;
            var json = await command.ExecuteScalarAsync(ct) as string;
            using var document = JsonDocument.Parse(json ?? "{\"available\":false}");
            database = document.RootElement.Clone();
        }
        catch (Exception exception) when (exception is NpgsqlException or TimeoutException)
        {
            // Connection strings and credentials must never appear in a monitoring response.
            database = new { available = false, reason = "Database counters could not be read." };
        }
        return Ok(new { sampledAt = DateTime.UtcNow, api, database });
    }
}
