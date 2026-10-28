namespace Shop.Api.Common.Storage;

/// <summary>A saved image: the name we gave the file on disk and its content type.</summary>
public record StoredImage(string FileName, string ContentType);

/// <summary>
/// Where images are kept. The rest of the code only knows this interface, so the disk
/// can later be replaced (e.g. by cloud storage) without touching the modules.
/// </summary>
public interface IImageStorage
{
    /// <summary>Saves an already validated image under a new random name.</summary>
    Task<StoredImage> SaveAsync(IFormFile file, CancellationToken ct);

    /// <summary>Opens a saved image for reading, or returns null if it does not exist.</summary>
    Stream? OpenRead(string fileName);

    void Delete(string fileName);
}
