using Microsoft.EntityFrameworkCore;
using Shop.Api.Common;
using Shop.Api.Common.Errors;
using Shop.Api.Common.Paging;
using Shop.Api.Common.Storage;
using Shop.Api.Integrations.Inventory;
using Shop.Api.Modules.Products.Dtos;

namespace Shop.Api.Modules.Products;

public class ProductsService
{
    private readonly ProductsDbContext _db;
    private readonly IImageStorage _imageStorage;
    private readonly IInventoryService _inventory; // the stock lives in the inventory service, not in our database
    private readonly ILogger<ProductsService> _logger;

    public ProductsService(
        ProductsDbContext db,
        IImageStorage imageStorage,
        IInventoryService inventory,
        ILogger<ProductsService> logger)
    {
        _db = db;
        _imageStorage = imageStorage;
        _inventory = inventory;
        _logger = logger;
    }

    public async Task<ProductResponse> CreateAsync(CreateProductRequest request, CancellationToken ct)
    {
        // 1. The file goes to the disk first; the database only keeps its name.
        var image = await _imageStorage.SaveAsync(request.Image!, ct);

        var product = new Product
        {
            Id = Guid.NewGuid(),
            Name = request.Name.Trim(),
            Description = request.Description.Trim(),
            Price = request.Price,
            Category = NormalizeCategory(request.Category),
            ImageFileName = image.FileName,
            ImageContentType = image.ContentType,
            CreatedAt = DateTime.UtcNow,
        };

        // 2. If saving the row fails, delete the file again, so no orphan images pile up on the disk.
        try
        {
            _db.Products.Add(product);
            await _db.SaveChangesAsync(ct);
        }
        catch
        {
            _imageStorage.Delete(image.FileName);
            throw;
        }

        _logger.LogInformation("Product {ProductId} created in category {Category}", product.Id, product.Category);
        return ToResponse(product);
    }

    public async Task<PagedResponse<ProductResponse>> ListAsync(ProductQuery query, CancellationToken ct)
    {
        var products = _db.Products.AsNoTracking();

        if (!string.IsNullOrWhiteSpace(query.Category))
        {
            var category = NormalizeCategory(query.Category);
            products = products.Where(p => p.Category == category);
        }

        var totalCount = await products.CountAsync(ct);

        // A stable order is required for paging; otherwise an item could show up on two pages.
        var items = await products
            .OrderByDescending(p => p.CreatedAt)
            .ThenBy(p => p.Id)
            .Skip((query.Page - 1) * query.PageSize)
            .Take(query.PageSize)
            .ToListAsync(ct);

        return PagedResponse<ProductResponse>.Create(
            items.Select(ToResponse).ToList(), query.Page, query.PageSize, totalCount);
    }

    public async Task<ProductResponse> GetByIdAsync(Guid id, CancellationToken ct)
    {
        var product = await FindAsync(id, ct);

        // Ask the inventory service how many are left. If it is down or too slow, the product page
        // still works: we show the product without its stock (null) instead of failing the whole page.
        int? stock;
        try
        {
            stock = await _inventory.GetStockAsync(id, ct);
        }
        catch (ServiceUnavailableException)
        {
            stock = null;
        }

        return ToResponse(product) with { Stock = stock };
    }

    public async Task<StockResponse> SetStockAsync(Guid id, int quantity, CancellationToken ct)
    {
        await FindAsync(id, ct); // 404 for a product that does not exist

        var stock = await _inventory.SetStockAsync(id, quantity, ct);
        _logger.LogInformation("Stock of product {ProductId} set to {Stock}", id, stock);
        return new StockResponse(id, stock);
    }

    public async Task<(Stream Content, string ContentType)> GetImageAsync(Guid id, CancellationToken ct)
    {
        var product = await FindAsync(id, ct);
        var stream = _imageStorage.OpenRead(product.ImageFileName)
            ?? throw new NotFoundException($"The image of product {id} was not found.");
        return (stream, product.ImageContentType);
    }

    private async Task<Product> FindAsync(Guid id, CancellationToken ct) =>
        await _db.Products.AsNoTracking().SingleOrDefaultAsync(p => p.Id == id, ct)
        ?? throw new NotFoundException($"Product {id} was not found.");

    private static string NormalizeCategory(string category) => category.Trim().ToLowerInvariant();

    private static ProductResponse ToResponse(Product p) => new(
        p.Id, p.Name, p.Description, p.Price, p.Category,
        $"/{ApiRoutes.V1}/products/{p.Id}/image", p.CreatedAt);
}