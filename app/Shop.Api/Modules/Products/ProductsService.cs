using Microsoft.EntityFrameworkCore;
using Shop.Api.Common;
using Shop.Api.Common.Errors;
using Shop.Api.Common.Paging;
using Shop.Api.Common.Storage;
using Shop.Api.Modules.Products.Dtos;

namespace Shop.Api.Modules.Products;

public class ProductsService
{
    private readonly ProductsDbContext _db;
    private readonly IImageStorage _imageStorage;
    private readonly ILogger<ProductsService> _logger;

    public ProductsService(ProductsDbContext db, IImageStorage imageStorage, ILogger<ProductsService> logger)
    {
        _db = db;
        _imageStorage = imageStorage;
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
        return ToResponse(product);
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
