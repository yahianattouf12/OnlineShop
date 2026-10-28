namespace Shop.Api.Common.Errors;

/// <summary>404: the resource does not exist, or it exists but the caller is not allowed to know that.</summary>
public sealed class NotFoundException : AppException
{
    public NotFoundException(string detail)
        : base(StatusCodes.Status404NotFound, "Not found", detail)
    {
    }
}
