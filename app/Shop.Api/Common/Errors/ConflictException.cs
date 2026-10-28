namespace Shop.Api.Common.Errors;

/// <summary>409: the request conflicts with the current state (e.g. the email is already registered, not enough stock).</summary>
public sealed class ConflictException : AppException
{
    public ConflictException(string detail)
        : base(StatusCodes.Status409Conflict, "Conflict", detail)
    {
    }
}
