using System.ComponentModel.DataAnnotations;

namespace Shop.Api.Common.Auth;

/// <summary>The "Jwt" section of the configuration. The Key is a secret: user-secrets locally, an environment variable in Docker.</summary>
public class JwtOptions
{
    public const string SectionName = "Jwt";

    [Required] public string Issuer { get; set; } = "";
    [Required] public string Audience { get; set; } = "";
    [Required, MinLength(32)] public string Key { get; set; } = "";
    [Range(1, 1440)] public int ExpiryMinutes { get; set; } = 60;
}
