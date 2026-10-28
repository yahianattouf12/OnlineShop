namespace Shop.Api.Common.Security;

public static class SecurityHeadersSetup
{
    /// <summary>
    /// Adds the basic security headers to every response, including error responses.
    /// OnStarting runs just before the response is sent, so later middleware cannot remove them.
    /// </summary>
    public static WebApplication UseSecurityHeaders(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            context.Response.OnStarting(() =>
            {
                var headers = context.Response.Headers;

                // Do not guess the content type; trust our Content-Type header.
                headers["X-Content-Type-Options"] = "nosniff";
                // Our pages may not be shown inside a frame on another site (clickjacking).
                headers["X-Frame-Options"] = "DENY";
                // Do not send our URLs to other sites in the Referer header.
                headers["Referrer-Policy"] = "no-referrer";

                // The API only returns JSON, so it needs no scripts, styles or frames.
                // Swagger UI does need its own scripts and styles, so it is skipped.
                if (!context.Request.Path.StartsWithSegments("/swagger"))
                    headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";

                return Task.CompletedTask;
            });

            await next();
        });

        return app;
    }
}
