using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Shop.Api.Common.Security;

public static class RateLimitingSetup
{
    /// <summary>The policy name to put on an endpoint: [EnableRateLimiting(RateLimitingSetup.LoginPolicy)].</summary>
    public const string LoginPolicy = "login";

    /// <summary>
    /// Brute-force protection: each IP address may try to log in 5 times per minute.
    /// The 6th try gets 429 Too Many Requests until the minute is over.
    /// </summary>
    public static IServiceCollection AddLoginRateLimiting(this IServiceCollection services)
    {
        services.AddRateLimiter(options =>
        {
            // The default is 503, which would wrongly say the server is down.
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

            options.AddPolicy(LoginPolicy, httpContext =>
                RateLimitPartition.GetFixedWindowLimiter(
                    // One counter per IP address.
                    partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 5,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0, // reject at once, do not make the request wait
                    }));

            // Answer with a clear Problem Details message, and say how many seconds to wait.
            options.OnRejected = async (context, _) =>
            {
                if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
                    context.HttpContext.Response.Headers.RetryAfter = ((int)retryAfter.TotalSeconds).ToString();

                var problemDetails = context.HttpContext.RequestServices.GetRequiredService<IProblemDetailsService>();
                await problemDetails.WriteAsync(new ProblemDetailsContext
                {
                    HttpContext = context.HttpContext,
                    ProblemDetails =
                    {
                        Status = StatusCodes.Status429TooManyRequests,
                        Title = "Too many requests",
                        Detail = "Too many login attempts. Please wait a minute and try again.",
                    },
                });
            };
        });

        return services;
    }
}
