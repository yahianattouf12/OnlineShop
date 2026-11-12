using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Microsoft.Net.Http.Headers;
using Shop.Api.Common;
using Shop.Api.Common.Auth;
using Shop.Api.Common.Paging;
using Shop.Api.Common.Storage;
using Shop.Api.Modules.Products.Dtos;

namespace Shop.Api.Modules.Products;

[ApiController]
[Route(ApiRoutes.V1 + "/products")]
public class ProductsController : ControllerBase
{
    private readonly ProductsService _productsService;
    private readonly JsonSerializerOptions _jsonOptions;

    public ProductsController(ProductsService productsService, IOptions<JsonOptions> jsonOptions)
    {
        _productsService = productsService;
        _jsonOptions = jsonOptions.Value.JsonSerializerOptions;
    }

    /// <summary>Adds a product with its image (admin only).</summary>
    [HttpPost]
    [Authorize(Roles = Roles.Admin)]
    [Consumes("multipart/form-data")]
    // Rejects huge bodies (413) before they are even read: the 5 MB image plus some room for the text fields.
    [RequestSizeLimit(ImageFileAttribute.MaxBytes + 1024 * 1024)]
    [ProducesResponseType<ProductResponse>(StatusCodes.Status201Created)]
    public async Task<IActionResult> Create([FromForm] CreateProductRequest request, CancellationToken ct)
    {
        var product = await _productsService.CreateAsync(request, ct);
        return CreatedAtAction(nameof(GetById), new { id = product.Id }, product);
    }

    /// <summary>Lists products, newest first, with an optional category filter and paging.</summary>
    [HttpGet]
    public Task<PagedResponse<ProductResponse>> List([FromQuery] ProductQuery query, CancellationToken ct) =>
        _productsService.ListAsync(query, ct);

    /// <summary>One product, with how many units are in stock (asked from the inventory service).</summary>
    [HttpGet("{id:guid}")]
    [ProducesResponseType<ProductResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status304NotModified)]
    public async Task<ActionResult<ProductResponse>> GetById(Guid id, CancellationToken ct)
    {
        var product = await _productsService.GetByIdAsync(id, ct);
        var json = JsonSerializer.SerializeToUtf8Bytes(product, _jsonOptions);
        var hash = Convert.ToHexString(SHA256.HashData(json));
        var etag = new EntityTagHeaderValue($"\"{hash}\"", isWeak: true);

        var headers = Response.GetTypedHeaders();
        headers.ETag = etag;
        headers.CacheControl = new CacheControlHeaderValue { NoCache = true };

        if (Request.GetTypedHeaders().IfNoneMatch.Any(candidate =>
                candidate.Equals(EntityTagHeaderValue.Any) ||
                candidate.Compare(etag, useStrongComparison: false)))
        {
            return StatusCode(StatusCodes.Status304NotModified);
        }

        return Ok(product);
    }

    /// <summary>Sets how many units of the product are in stock (admin only).</summary>
    [HttpPut("{id:guid}/stock")]
    [Authorize(Roles = Roles.Admin)]
    public Task<StockResponse> SetStock(Guid id, SetStockRequest request, CancellationToken ct) =>
        _productsService.SetStockAsync(id, request.Quantity!.Value, ct);

    /// <summary>The product's image file.</summary>
    [HttpGet("{id:guid}/image")]
    public async Task<IActionResult> GetImage(Guid id, CancellationToken ct)
    {
        var (content, contentType) = await _productsService.GetImageAsync(id, ct);
        return File(content, contentType);
    }
}
