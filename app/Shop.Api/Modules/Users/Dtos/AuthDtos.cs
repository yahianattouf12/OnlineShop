using System.ComponentModel.DataAnnotations;

namespace Shop.Api.Modules.Users.Dtos;

// No "Role" field on purpose: a client must never choose its own role (mass assignment).
public class RegisterRequest
{
    [Required, EmailAddress, MaxLength(255)]
    public string Email { get; set; } = "";

    [Required, MinLength(8), MaxLength(100)]
    public string Password { get; set; } = "";
}

public class LoginRequest
{
    [Required, EmailAddress]
    public string Email { get; set; } = "";

    [Required]
    public string Password { get; set; } = "";
}

public record UserResponse(Guid Id, string Email, string Role, DateTime CreatedAt);

public record LoginResponse(string AccessToken, DateTime ExpiresAtUtc, string Role);
