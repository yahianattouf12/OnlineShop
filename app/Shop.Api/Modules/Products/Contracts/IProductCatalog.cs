namespace Shop.Api.Modules.Products.Contracts;

/// <summary>What another module may know about a product.</summary>
public record ProductInfo(Guid Id, string Name, decimal Price);

/// <summary>
/// The public door into the Products module. Other modules (e.g. Orders) use this interface
/// and never ProductsDbContext, so they never read the products tables directly.
/// </summary>
public interface IProductCatalog
{
    /// <summary>The products that exist among the given ids, keyed by id. Unknown ids are simply missing.</summary>
    Task<IReadOnlyDictionary<Guid, ProductInfo>> GetProductsAsync(IReadOnlyCollection<Guid> ids, CancellationToken ct);
}
