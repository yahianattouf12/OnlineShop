namespace Shop.Api.Common.Errors;

/// <summary>401: the caller is not logged in, or the login failed.</summary>
public sealed class UnauthorizedException : AppException
{
    public UnauthorizedException(string detail)
        : base(StatusCodes.Status401Unauthorized, "Unauthorized", detail)
    {
    }
}
