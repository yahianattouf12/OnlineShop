using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;

namespace Shop.Api.Common.Auth;

public static class AuthSetup
{
    /// <summary>JWT login: checks the token on every request and fills HttpContext.User from its claims.</summary>
    public static IServiceCollection AddJwtAuth(this IServiceCollection services, IConfiguration configuration)
    {
        // A missing or short Jwt:Key stops the app at startup, not at the first login.
        services.AddOptions<JwtOptions>()
            .Bind(configuration.GetSection(JwtOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        var jwt = configuration.GetSection(JwtOptions.SectionName).Get<JwtOptions>() ?? new JwtOptions();

        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(options =>
            {
                options.MapInboundClaims = false; // keep "sub" and "role" as they are in the token
                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidIssuer = jwt.Issuer,
                    ValidateAudience = true,
                    ValidAudience = jwt.Audience,
                    ValidateIssuerSigningKey = true,
                    IssuerSigningKey = JwtTokenService.CreateSigningKey(jwt),
                    ValidateLifetime = true,
                    ClockSkew = TimeSpan.FromSeconds(30),
                    NameClaimType = AppClaims.UserId,
                    RoleClaimType = AppClaims.Role, // makes [Authorize(Roles = ...)] read our "role" claim
                };
            });

        services.AddAuthorization();
        services.AddHttpContextAccessor();
        services.AddSingleton<JwtTokenService>();
        services.AddScoped<ICurrentUser, CurrentUser>();

        return services;
    }
}
