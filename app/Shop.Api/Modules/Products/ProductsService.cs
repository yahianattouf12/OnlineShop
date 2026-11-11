using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Distributed;
using Shop.Api.Common;
using Shop.Api.Common.Errors;
using Shop.Api.Common.Paging;
using Shop.Api.Common.Storage;
using Shop.Api.Integrations.Inventory;
using Shop.Api.Modules.Products.Dtos;
using StackExchange.Redis;

namespace Shop.Api.Modules.Products;

public class ProductsService
{
    private static readonly TimeSpan MetadataCacheLifetime = TimeSpan.FromSeconds(60);

    private readonly ProductsDbContext _db;
    private readonly IImageStorage _imageStorage;
    private readonly IInventoryService _inventory; // the stock lives in the inventory service, not in our database
    private readonly ILogger<ProductsService> _logger;
    private readonly IDistributedCache? _metadataCache;

    public ProductsService(
        ProductsDbContext db,
        IImageStorage imageStorage,
        IInventoryService inventory,
        ILogger<ProductsService> logger,
        IDistributedCache? metadataCache = null)
    {
        _db = db;
        _imageStorage = imageStorage;
        _inventory = inventory;
        _logger = logger;
        _metadataCache = metadataCache;
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
        var metadata = await GetProductMetadataAsync(id, ct);

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

        return metadata with { Stock = stock };
    }

    public async Task<StockResponse> SetStockAsync(Guid id, int quantity, CancellationToken ct)
    {
        await FindAsync(id, ct); // 404 for a product that does not exist

        var stock = await _inventory.SetStockAsync(id, quantity, ct);
        await InvalidateProductMetadataAsync(id);
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

    private async Task<ProductResponse> GetProductMetadataAsync(Guid id, CancellationToken ct)
    {
        if (_metadataCache is null)
            return ToResponse(await FindAsync(id, ct));

        var key = MetadataCacheKey(id);
        try
        {
            var cached = await _metadataCache.GetAsync(key, ct);
            if (cached is not null && JsonSerializer.Deserialize<ProductResponse>(cached) is { } metadata)
                return metadata;
        }
        catch (Exception error) when (error is RedisException or TimeoutException or JsonException)
        {
            _logger.LogWarning(error, "Could not read cached metadata for product {ProductId}", id);
            return ToResponse(await FindAsync(id, ct));
        }

        var product = ToResponse(await FindAsync(id, ct));
        try
        {
            var options = new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = MetadataCacheLifetime,
            };
            await _metadataCache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(product), options, ct);
        }
        catch (Exception error) when (error is RedisException or TimeoutException)
        {
            _logger.LogWarning(error, "Could not cache metadata for product {ProductId}", id);
        }

        return product;
    }

    private async Task InvalidateProductMetadataAsync(Guid id)
    {
        if (_metadataCache is null)
            return;

        try
        {
            // The inventory write succeeded. Attempt eviction even if the client disconnects.
            await _metadataCache.RemoveAsync(MetadataCacheKey(id), CancellationToken.None);
        }
        catch (Exception error) when (error is RedisException or TimeoutException)
        {
            _logger.LogWarning(error, "Could not evict cached metadata for product {ProductId}", id);
        }
    }

    private static string MetadataCacheKey(Guid id) => $"product:metadata:v1:{id:D}";

    private async Task<Product> FindAsync(Guid id, CancellationToken ct) =>
        await _db.Products.AsNoTracking().SingleOrDefaultAsync(p => p.Id == id, ct)
        ?? throw new NotFoundException($"Product {id} was not found.");

    private static string NormalizeCategory(string category) => category.Trim().ToLowerInvariant();

    private static ProductResponse ToResponse(Product p) => new(
        p.Id, p.Name, p.Description, p.Price, p.Category,
        $"/{ApiRoutes.V1}/products/{p.Id}/image", p.CreatedAt);
}
