namespace Shop.Api.Common.Auth;

/// <summary>The roles a user can have. Use them in [Authorize(Roles = Roles.Admin)].</summary>
public static class Roles
{
    public const string Customer = "Customer";
    public const string Admin = "Admin";
}

/// <summary>The names of the claims we put inside our JWTs.</summary>
public static class AppClaims
{
    public const string UserId = "sub";
    public const string Role = "role";
}
