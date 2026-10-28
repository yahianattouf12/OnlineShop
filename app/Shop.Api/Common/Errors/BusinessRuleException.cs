namespace Shop.Api.Common.Errors;

/// <summary>422: the request is well-formed but breaks a business rule (e.g. an invalid order status change).</summary>
public sealed class BusinessRuleException : AppException
{
    public BusinessRuleException(string detail)
        : base(StatusCodes.Status422UnprocessableEntity, "Business rule violated", detail)
    {
    }
}
