namespace Shop.Api.Common.Errors;

/// <summary>403: the caller is logged in but not allowed to do this.</summary>
public sealed class ForbiddenException : AppException
{
    public ForbiddenException(string detail = "You are not allowed to perform this action.")
        : base(StatusCodes.Status403Forbidden, "Forbidden", detail)
    {
    }
}
