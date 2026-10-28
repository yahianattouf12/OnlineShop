using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;

namespace Shop.Api.Common.Errors;

/// <summary>
/// The one place that turns exceptions into HTTP responses, so every error has the same shape.
/// Runs inside app.UseExceptionHandler(), which must be the first middleware in Program.cs.
/// </summary>
public sealed class GlobalExceptionHandler : IExceptionHandler
{
    private readonly IProblemDetailsService _problemDetailsService;
    private readonly ILogger<GlobalExceptionHandler> _logger;

    public GlobalExceptionHandler(IProblemDetailsService problemDetailsService, ILogger<GlobalExceptionHandler> logger)
    {
        _problemDetailsService = problemDetailsService;
        _logger = logger;
    }

    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        var problem = ToProblemDetails(httpContext, exception);

        httpContext.Response.StatusCode = problem.Status ?? StatusCodes.Status500InternalServerError;

        // Writes the body as application/problem+json and adds "traceId" and "instance".
        return await _problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails = problem,
        });
    }

    private ProblemDetails ToProblemDetails(HttpContext httpContext, Exception exception)
    {
        // An error we threw on purpose: its message is safe to show.
        if (exception is AppException appException)
        {
            var problem = new ProblemDetails
            {
                Status = appException.StatusCode,
                Title = appException.Title,
                Detail = appException.Message,
            };

            foreach (var (key, value) in appException.Extensions)
                problem.Extensions[key] = value;

            return problem;
        }

        // The framework could not read the request (e.g. the body is too large).
        if (exception is BadHttpRequestException badRequest)
        {
            return new ProblemDetails { Status = badRequest.StatusCode, Title = "Bad request" };
        }

        // Anything else is a bug. Log the real exception, but never send its message or
        // stack trace to the client: they can reveal internals to an attacker.
        _logger.LogError(exception, "Unhandled exception for {Method} {Path}",
            httpContext.Request.Method, httpContext.Request.Path);

        return new ProblemDetails
        {
            Status = StatusCodes.Status500InternalServerError,
            Title = "An unexpected error occurred.",
        };
    }
}
