namespace Shop.Api.Modules.Products;

public class Product
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public decimal Price { get; set; }

    /// <summary>Always stored in lower case, so filtering by category ignores case.</summary>
    public string Category { get; set; } = "";

    /// <summary>The name we gave the image file on disk (never the name the client sent).</summary>
    public string ImageFileName { get; set; } = "";
    public string ImageContentType { get; set; } = "";

    public DateTime CreatedAt { get; set; }
}
