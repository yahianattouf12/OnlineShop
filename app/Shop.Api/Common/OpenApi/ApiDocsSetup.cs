using Microsoft.OpenApi;

namespace Shop.Api.Common.OpenApi;

public static class ApiDocsSetup
{
    private const string DocumentUrl = "/openapi/v1.json";
    private const string BearerScheme = "Bearer";

    /// <summary>Generates the OpenAPI document that describes every endpoint, with a JWT "Authorize" button.</summary>
    public static IServiceCollection AddApiDocs(this IServiceCollection services)
    {
        services.AddOpenApi(options => options.AddDocumentTransformer((document, _, _) =>
        {
            document.Info.Title = "OnlineShop API";

            // Tells Swagger UI that the API uses "Authorization: Bearer <token>".
            document.Components ??= new OpenApiComponents();
            document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();
            document.Components.SecuritySchemes[BearerScheme] = new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.Http,
                Scheme = "bearer",
                BearerFormat = "JWT",
                Description = "Paste the accessToken returned by POST /api/v1/auth/login.",
            };

            document.Security ??= [];
            document.Security.Add(new OpenApiSecurityRequirement
            {
                [new OpenApiSecuritySchemeReference(BearerScheme, document)] = [],
            });

            return Task.CompletedTask;
        }));

        return services;
    }

    /// <summary>The OpenAPI document at /openapi/v1.json and Swagger UI at /swagger.</summary>
    public static WebApplication UseApiDocs(this WebApplication app)
    {
        app.MapOpenApi();
        app.UseSwaggerUI(options => options.SwaggerEndpoint(DocumentUrl, "OnlineShop API v1"));
        return app;
    }
}
