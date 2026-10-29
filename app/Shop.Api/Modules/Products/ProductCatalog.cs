using Microsoft.EntityFrameworkCore;
using Shop.Api.Modules.Products.Contracts;

namespace Shop.Api.Modules.Products;

/// <summary>The Products module's own implementation of its public contract.</summary>
internal sealed class ProductCatalog : IProductCatalog
{
    private readonly ProductsDbContext _db;

    public ProductCatalog(ProductsDbContext db)
    {
        _db = db;
    }

    public async Task<IReadOnlyDictionary<Guid, ProductInfo>> GetProductsAsync(IReadOnlyCollection<Guid> ids, CancellationToken ct) =>
        await _db.Products
            .AsNoTracking()
            .Where(p => ids.Contains(p.Id))
            .Select(p => new ProductInfo(p.Id, p.Name, p.Price))
            .ToDictionaryAsync(p => p.Id, ct);
}
