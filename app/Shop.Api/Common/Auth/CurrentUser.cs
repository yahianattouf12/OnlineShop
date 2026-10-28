using System.Security.Claims;

namespace Shop.Api.Common.Auth;

/// <summary>
/// Who is calling, read from the JWT. Always use this for ownership checks;
/// never trust a user id sent in the URL or the body.
/// </summary>
public interface ICurrentUser
{
    /// <summary>Throws if nobody is logged in, so only use it behind [Authorize].</summary>
    Guid Id { get; }

    bool IsAdmin { get; }
}

public class CurrentUser : ICurrentUser
{
    private readonly IHttpContextAccessor _accessor;

    public CurrentUser(IHttpContextAccessor accessor)
    {
        _accessor = accessor;
    }

    private ClaimsPrincipal? Principal => _accessor.HttpContext?.User;

    public Guid Id => Guid.TryParse(Principal?.FindFirstValue(AppClaims.UserId), out var id)
        ? id
        : throw new InvalidOperationException("The request has no authenticated user.");

    public bool IsAdmin => Principal?.IsInRole(Roles.Admin) == true;
}
