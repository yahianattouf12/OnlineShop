namespace Shop.Api.Common.OpenApi;

public static class ApiDocsSetup
{
    private const string DocumentUrl = "/openapi/v1.json";

    /// <summary>Generates the OpenAPI document that describes every endpoint.</summary>
    public static IServiceCollection AddApiDocs(this IServiceCollection services)
    {
        // Step 2 (JWT) adds the "Authorize" button here with a document transformer.
        services.AddOpenApi(options => options.AddDocumentTransformer((document, _, _) =>
        {
            document.Info.Title = "OnlineShop API";
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
