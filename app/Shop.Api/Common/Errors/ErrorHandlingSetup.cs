using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Infrastructure;

namespace Shop.Api.Common.Errors;

public static class ErrorHandlingSetup
{

    public static IServiceCollection AddApiErrorHandling(this IServiceCollection services)
    {
        // Problem Details everywhere. "instance" = the path of the request that failed.
        services.AddProblemDetails(options =>
            options.CustomizeProblemDetails = context =>
                context.ProblemDetails.Instance ??= context.HttpContext.Request.Path);

        services.AddExceptionHandler<GlobalExceptionHandler>();

        // [ApiController] answers invalid input with 400 by default; we want 422.
        // PostConfigure runs after AddControllers() has set its own default, so ours wins.
        services.PostConfigure<ApiBehaviorOptions>(options =>
            options.InvalidModelStateResponseFactory = context =>
            {
                var factory = context.HttpContext.RequestServices.GetRequiredService<ProblemDetailsFactory>();
                var problem = factory.CreateValidationProblemDetails(
                    context.HttpContext, context.ModelState, StatusCodes.Status422UnprocessableEntity);

                return new UnprocessableEntityObjectResult(problem)
                {
                    ContentTypes = { "application/problem+json" },
                };
            });

        return services;
    }
}
