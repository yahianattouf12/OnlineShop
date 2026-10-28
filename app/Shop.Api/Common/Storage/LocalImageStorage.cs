using Microsoft.Extensions.Options;

namespace Shop.Api.Common.Storage;

/// <summary>The "Storage" section of the configuration.</summary>
public class StorageOptions
{
    public const string SectionName = "Storage";

    /// <summary>The folder for uploaded images. Relative paths start at the app folder. In Docker this is a volume.</summary>
    public string RootPath { get; set; } = "uploads";
}

/// <summary>Keeps images as files in one folder on the server's disk.</summary>
public class LocalImageStorage : IImageStorage
{
    private readonly string _rootPath;

    public LocalImageStorage(IOptions<StorageOptions> options, IWebHostEnvironment environment)
    {
        _rootPath = Path.GetFullPath(Path.Combine(environment.ContentRootPath, options.Value.RootPath));
        Directory.CreateDirectory(_rootPath);
    }

    public async Task<StoredImage> SaveAsync(IFormFile file, CancellationToken ct)
    {
        var extension = Path.GetExtension(file.FileName).ToLowerInvariant();

        // Never use the client's file name: it could be "../../Program.cs" (path traversal)
        // or overwrite another product's image. A random name is safe and unique.
        var fileName = $"{Guid.NewGuid():N}{extension}";

        await using var target = File.Create(PathFor(fileName));
        await file.CopyToAsync(target, ct);

        return new StoredImage(fileName, ImageFileAttribute.ContentTypeFor(extension));
    }

    public Stream? OpenRead(string fileName)
    {
        var path = PathFor(fileName);
        return File.Exists(path) ? File.OpenRead(path) : null;
    }

    public void Delete(string fileName)
    {
        var path = PathFor(fileName);
        if (File.Exists(path))
            File.Delete(path);
    }

    // Second line of defence: a name with folders in it ("../x") never leaves the root folder.
    private string PathFor(string fileName)
    {
        if (fileName != Path.GetFileName(fileName))
            throw new ArgumentException("Invalid file name.", nameof(fileName));

        return Path.Combine(_rootPath, fileName);
    }
}
